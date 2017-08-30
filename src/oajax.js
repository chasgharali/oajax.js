
var oajax ={
	
  logMsg : 0,
  
  request : function( Type , URL  , Data , ContentType ,callback){
  
    $.ajax({
          
          type: Type,
          url: URL,
		  data:  JSON.stringify(Data) ,
		  contentType: ContentType ,
         
          success: function(data){
              window.localStorage.setItem("cache@" + URL + "%" +JSON.stringify(Data) , JSON.stringify(data) );
              
			  if(oajax.logMsg)
			  console.log("getting data online");
             
			  callback(data);
          
        },
          error: function (request, status, error) {
           
		    
			 
			 if (localStorage.getItem("cache@" + URL + "%" +JSON.stringify(Data)) === null) {
            
				var handler = "request@" + URL + "%" +JSON.stringify(Data);
			
				if(localStorage.getItem(handler) === null){
					var Request = {
									type: Type,
									url: URL,
									data:  JSON.stringify(Data),
									contentType: ContentType 
								  };
								 
					
					window.localStorage.setItem(handler , JSON.stringify(Request));
					sync_que =  oajax.getQue();
					sync_que.push(handler);
					window.localStorage.setItem("sync_que" , JSON.stringify(sync_que));
					callback("{\"error\" : \"404\"}");
				}
				else{
					callback("{\"error\" : \"404\"}");
				}
				
             }
             else{
				 
				 if(oajax.logMsg)
                console.log("getting data offline");
                callback(localStorage.getItem("cache@" + URL + "%" + JSON.stringify(Data)));
             }
          }
      }); 
  },

  
  getQue : function(){
    if (localStorage.getItem("sync_que") === null) {
        window.localStorage.setItem("sync_que" , JSON.stringify([]));
        return [];     
    }
    else{
        var que =localStorage.getItem("sync_que");
         return JSON.parse(que);
    }

  },

  queHandle : function(){
    sync_que =  oajax.getQue();
      
      var i = 0;
		for(; i < sync_que.length ; ++i ){
         
         oajax.syncData(sync_que[i], function(e){
           if(e=="success"){
			 sync_que.splice(i, 1);
		   }
		   
           
         });
        
         
    }
    window.localStorage.setItem("sync_que" , JSON.stringify(sync_que));
  },
 
 
  syncData : function(handler , callback){
    
	var Request = JSON.parse(localStorage.getItem(handler));
	
	
	$.ajax({
			
			type: Request.type ,
			async: false,
			url: Request.url ,
			data: Request.data ,
			contentType: Request.contentType ,
			
            
			success: function(data){
				
				 window.localStorage.setItem("cache@" +  Request.url + "%" + Request.data, JSON.stringify(data) );
				
                 if(oajax.logMsg)
				console.log(handler +": "+ Request.url + " sync with server");
                localStorage.removeItem(handler);
				callback("success");
            },
            error: function (request, status, error){
                callback("error");
            }
       
       });
  
  }



} ;




$(document).ready ( function(){
  var SyncInterval = 10 * 1000;

  window.setInterval(function(){
          oajax.queHandle();
          
  }, SyncInterval);

});